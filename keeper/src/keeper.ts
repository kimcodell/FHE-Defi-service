// PrivateLendingPool 청산 점검 봇
//
// 주기적으로 poke(CHECKS_PER_TICK)을 호출해 다음 순번 포지션을 블라인드 청산 점검한다.
// - poke는 반환값이 없고, 이벤트도 PositionChecked(user)뿐이다. 청산 대상이었는지는 봇도 알 수 없다.
// - 청산 대상이면 컨트랙트가 같은 트랜잭션 안에서 암호문으로 청산까지 끝낸다.
// - 청산과 비청산은 이벤트 순서와 gasUsed까지 같다 (hardhat/test/lendingPool.ts에서 확인).
//
// 실행:  npm start             계속 돈다 (Ctrl+C로 종료)
//        npm run once          한 번만 점검하고 끝낸다
//        npm run dry-run       트랜잭션을 보내지 않고 시뮬레이션만 한다 (개인키 불필요)

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const poolAbi = [
  { type: "function", name: "poke", stateMutability: "nonpayable", inputs: [{ name: "count", type: "uint256" }], outputs: [] },
  { type: "function", name: "positionCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nextCheckIndex", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "positionAt", stateMutability: "view", inputs: [{ name: "i", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = new Set(process.argv.slice(2));
const ONCE = args.has("--once");
const DRY_RUN = args.has("--dry-run");

const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const INTERVAL_SECONDS = intEnv("INTERVAL_SECONDS", 60, 5, 86_400);
const CHECKS_PER_TICK = intEnv("CHECKS_PER_TICK", 1, 1, 3);
const LOW_BALANCE_WEI = 10n ** 16n; // 0.01 ETH 아래면 경고
const POOL = resolvePoolAddress();

function fail(message: string): never {
  console.error(`설정 오류: ${message}`);
  process.exit(1);
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(`${name}=${raw} 은(는) ${min}~${max} 사이 정수여야 합니다.`);
  }
  return n;
}

function resolvePoolAddress(): Address {
  const fromEnv = process.env.POOL_ADDRESS;
  if (fromEnv) {
    if (!isAddress(fromEnv)) fail(`POOL_ADDRESS가 주소 형식이 아닙니다: ${fromEnv}`);
    return fromEnv;
  }
  const deployments = fileURLToPath(new URL("../../frontend/src/contracts/deployments.json", import.meta.url));
  if (existsSync(deployments)) {
    const json = JSON.parse(readFileSync(deployments, "utf8")) as Record<string, Record<string, string>>;
    const address = json[String(sepolia.id)]?.PrivateLendingPool;
    if (address && isAddress(address)) return address;
  }
  fail("대출 풀 주소를 찾지 못했습니다. .env에 POOL_ADDRESS를 설정하세요.");
}

function loadAccount() {
  const raw = process.env.KEEPER_PRIVATE_KEY?.trim();
  if (!raw) {
    if (DRY_RUN) return undefined;
    fail("KEEPER_PRIVATE_KEY가 없습니다. .env.example을 .env로 복사해서 봇 전용 지갑의 개인키를 넣으세요.");
  }
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail("KEEPER_PRIVATE_KEY 형식이 올바르지 않습니다 (32바이트 16진수).");
  return privateKeyToAccount(key);
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

const account = loadAccount();
// 드라이런에 개인키가 없으면 아무 주소로 시뮬레이션한다 (eth_call이라 서명이 필요 없다).
const caller: Address = account?.address ?? "0x000000000000000000000000000000000000dEaD";

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: sepolia, transport });
const walletClient = account ? createWalletClient({ account, chain: sepolia, transport }) : undefined;

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal} 받음, 진행 중인 점검이 끝나면 종료합니다.`);
    stopping = true;
    wake?.();
  });
}

function sleep(seconds: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function tick() {
  const [count, cursor] = await Promise.all([
    publicClient.readContract({ address: POOL, abi: poolAbi, functionName: "positionCount" }),
    publicClient.readContract({ address: POOL, abi: poolAbi, functionName: "nextCheckIndex" }),
  ]);
  if (count === 0n) {
    log("등록된 포지션이 없어 건너뜁니다.");
    return;
  }

  // 다음에 점검될 순번 (공개 정보). 봇 자신의 포지션이면 컨트랙트가 건너뛰고 그다음을 점검한다.
  const next = await publicClient.readContract({
    address: POOL,
    abi: poolAbi,
    functionName: "positionAt",
    args: [cursor % count],
  });
  const target = `순번 ${cursor % count}/${count} (${short(next)})`;

  const { request } = await publicClient.simulateContract({
    address: POOL,
    abi: poolAbi,
    functionName: "poke",
    args: [BigInt(CHECKS_PER_TICK)],
    account: account ?? caller,
  });

  if (DRY_RUN || !walletClient) {
    const gas = await publicClient.estimateContractGas({
      address: POOL,
      abi: poolAbi,
      functionName: "poke",
      args: [BigInt(CHECKS_PER_TICK)],
      account: caller,
    });
    log(`[드라이런] poke(${CHECKS_PER_TICK}) 시뮬레이션 성공 · 대상 ${target} · 예상 가스 ${gas}`);
    return;
  }

  const hash = await walletClient.writeContract(request);
  log(`poke(${CHECKS_PER_TICK}) 전송 · 대상 ${target} · tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  // 결과(청산 여부)는 영수증에도 없다. 성공/실패와 가스만 남긴다.
  log(
    `  ${receipt.status === "success" ? "완료" : "실패"} · 블록 ${receipt.blockNumber} · 가스 ${receipt.gasUsed}` +
      ` · https://sepolia.etherscan.io/tx/${hash}`,
  );
}

async function checkBalance() {
  if (!account) return;
  const balance = await publicClient.getBalance({ address: account.address });
  if (balance < LOW_BALANCE_WEI) {
    log(`⚠ 봇 지갑 잔고가 ${formatEther(balance)} ETH뿐입니다. Sepolia 테스트 ETH를 채워 주세요.`);
  }
}

log(
  `청산 점검 봇 시작 · 풀 ${POOL} · 봇 지갑 ${account ? account.address : "(없음, 드라이런)"}` +
    ` · ${ONCE ? "1회" : `${INTERVAL_SECONDS}초마다`} poke(${CHECKS_PER_TICK})${DRY_RUN ? " · 드라이런" : ""}`,
);
await checkBalance();

let failures = 0;
while (!stopping) {
  try {
    await tick();
    failures = 0;
  } catch (err) {
    failures += 1;
    const message = err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : String(err);
    log(`점검 실패 (${failures}회 연속): ${message}`);
    if (ONCE) process.exitCode = 1;
  }
  if (ONCE || stopping) break;
  if (failures > 0 && failures % 10 === 0) await checkBalance();
  // 연속 실패하면 간격을 늘린다 (최대 10배)
  await sleep(INTERVAL_SECONDS * Math.min(2 ** Math.max(failures - 1, 0), 10));
}
log("종료합니다.");
