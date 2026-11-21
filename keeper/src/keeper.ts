// PrivateLendingPool 청산 점검 봇 (가격 감지형)
//
// 규칙
//   1. 시작할 때                    → 한 바퀴 점검, 기준 가격 = 현재 가격
//   2. 1분마다 가격 조회 (가스 없음)
//      · 가격이 기준보다 높으면      → 기준 가격을 올린다 (높은 가격에서 새로 빌린 사람 대비)
//      · 가격 ≤ 기준 × (1 − 2%)     → 한 바퀴 점검, 기준 가격 = 현재 가격 (끝나면 바로 다시 확인)
//   3. 마지막 바퀴 후 24시간이 지나면 → 한 바퀴 점검 (이자로 천천히 청산선을 넘는 포지션 대비)
//
// "한 바퀴" = 등록된 포지션 수만큼 poke(최대 3)를 이어서 호출해 모든 포지션을 한 번씩 점검하는 것.
// - poke는 반환값이 없고, 이벤트도 PositionChecked(user)뿐이다. 청산 대상이었는지는 봇도 알 수 없다.
// - 청산 대상이면 컨트랙트가 같은 트랜잭션 안에서 암호문으로 청산까지 끝낸다.
// - 봇의 판단 근거는 공개된 가격과 시간뿐이라, 봇이 언제 점검하는지에서 새는 정보도 없다.
//
// 실행:  npm start             계속 돈다 (Ctrl+C로 종료)
//        npm run once          한 바퀴만 점검하고 끝낸다
//        npm run dry-run       트랜잭션 없이 첫 트랜잭션만 시뮬레이션한다 (개인키 불필요)

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
  { type: "function", name: "currentPrice", stateMutability: "view", inputs: [], outputs: [{ name: "price", type: "uint64" }] },
] as const;

/** 컨트랙트의 MAX_CHECKS_PER_POKE */
const MAX_PER_POKE = 3n;
const BPS = 10_000n;

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = new Set(process.argv.slice(2));
const ONCE = args.has("--once");
const DRY_RUN = args.has("--dry-run");

const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const PRICE_POLL_SECONDS = intEnv("PRICE_POLL_SECONDS", 60, 5, 3_600);
const DROP_TRIGGER_BPS = BigInt(intEnv("DROP_TRIGGER_BPS", 200, 1, 5_000)); // 200 = 2%
const HEARTBEAT_HOURS = intEnv("HEARTBEAT_HOURS", 24, 1, 168);
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
// 준비
// ---------------------------------------------------------------------------

const account = loadAccount();
// 드라이런에 개인키가 없으면 아무 주소로 시뮬레이션한다 (eth_call이라 서명이 필요 없다).
const caller: Address = account?.address ?? "0x000000000000000000000000000000000000dEaD";

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: sepolia, transport });
const walletClient = account ? createWalletClient({ account, chain: sepolia, transport }) : undefined;

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;

let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal} 받음, 진행 중인 트랜잭션이 끝나면 종료합니다.`);
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

const readPrice = () => publicClient.readContract({ address: POOL, abi: poolAbi, functionName: "currentPrice" });

// ---------------------------------------------------------------------------
// 한 바퀴 점검
// ---------------------------------------------------------------------------

/** poke(count) 한 건. 결과(청산 여부)는 영수증에도 없어서 성공/실패와 가스만 남긴다. */
async function poke(count: bigint) {
  const { request } = await publicClient.simulateContract({
    address: POOL,
    abi: poolAbi,
    functionName: "poke",
    args: [count],
    account: account ?? caller,
  });
  const hash = await walletClient!.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`poke 트랜잭션 실패: ${hash}`);
  log(`  poke(${count}) 완료 · 가스 ${receipt.gasUsed} · https://sepolia.etherscan.io/tx/${hash}`);
}

/** 모든 포지션을 한 번씩 점검한다. 시작 시점의 가격을 돌려준다 (다음 기준 가격). */
async function round(reason: string): Promise<bigint | undefined> {
  const [count, price] = await Promise.all([
    publicClient.readContract({ address: POOL, abi: poolAbi, functionName: "positionCount" }),
    readPrice(),
  ]);
  if (count === 0n) {
    log(`${reason}: 등록된 포지션이 없어 건너뜁니다 (가격 ${price}).`);
    return BigInt(price);
  }
  const txCount = (count + MAX_PER_POKE - 1n) / MAX_PER_POKE;

  if (DRY_RUN || !walletClient) {
    const first = count < MAX_PER_POKE ? count : MAX_PER_POKE;
    const gas = await publicClient.estimateContractGas({
      address: POOL,
      abi: poolAbi,
      functionName: "poke",
      args: [first],
      account: caller,
    });
    log(
      `[드라이런] ${reason}: 포지션 ${count}개 · 가격 ${price} · 트랜잭션 ${txCount}건 예정` +
        ` · 첫 poke(${first}) 시뮬레이션 성공, 예상 가스 ${gas}`,
    );
    return BigInt(price);
  }

  log(`한 바퀴 시작 (${reason}) · 포지션 ${count}개 · 가격 ${price} · 트랜잭션 ${txCount}건`);
  let remaining = count;
  while (remaining > 0n) {
    if (stopping) throw new Error("종료 요청으로 한 바퀴를 마치지 못했습니다.");
    const n = remaining < MAX_PER_POKE ? remaining : MAX_PER_POKE;
    await poke(n);
    remaining -= n;
  }
  log(`한 바퀴 끝 · 기준 가격 ${price}`);
  return BigInt(price);
}

async function checkBalance() {
  if (!account) return;
  const balance = await publicClient.getBalance({ address: account.address });
  if (balance < LOW_BALANCE_WEI) {
    log(`⚠ 봇 지갑 잔고가 ${formatEther(balance)} ETH뿐입니다. Sepolia 테스트 ETH를 채워 주세요.`);
  }
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

log(
  `청산 점검 봇 시작 · 풀 ${POOL} · 봇 지갑 ${account ? account.address : "(없음, 드라이런)"}` +
    (ONCE || DRY_RUN
      ? ` · 한 바퀴만${DRY_RUN ? " (드라이런)" : ""}`
      : ` · 가격 확인 ${PRICE_POLL_SECONDS}초마다 · 하락 ${pct(DROP_TRIGGER_BPS)} 이상이면 한 바퀴 · ${HEARTBEAT_HOURS}시간마다 정기 한 바퀴`),
);
await checkBalance();

/** 마지막으로 한 바퀴를 돈 가격 (가격이 오르면 따라 올라간다). undefined면 아직 한 바퀴도 못 돈 상태. */
let reference: bigint | undefined;
let lastRoundAt = 0;
let failures = 0;

while (!stopping) {
  let ranRound = false;
  try {
    if (reference === undefined) {
      reference = await round("시작");
      lastRoundAt = Date.now();
      ranRound = true;
    } else {
      const price = BigInt(await readPrice());
      if (price > reference) {
        log(`가격 상승 ${reference} → ${price}, 기준 가격을 올립니다.`);
        reference = price;
      } else if (price * BPS <= reference * (BPS - DROP_TRIGGER_BPS)) {
        const drop = ((reference - price) * BPS) / reference;
        reference = await round(`가격 하락 ${reference} → ${price} (−${pct(drop)})`);
        lastRoundAt = Date.now();
        ranRound = true;
      } else if (Date.now() - lastRoundAt >= HEARTBEAT_HOURS * 3_600_000) {
        reference = await round(`정기 점검 (${HEARTBEAT_HOURS}시간 경과)`);
        lastRoundAt = Date.now();
        ranRound = true;
      }
    }
    failures = 0;
  } catch (err) {
    failures += 1;
    const message = err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err);
    log(`실패 (${failures}회 연속): ${message}`);
    if (ONCE || DRY_RUN) process.exitCode = 1;
    if (failures % 10 === 0) await checkBalance();
  }
  if (ONCE || DRY_RUN || stopping) break;
  // 한 바퀴를 막 끝냈으면 기다리지 않고 바로 가격을 다시 확인한다 (점검 중에 더 떨어졌을 수 있다).
  if (ranRound && failures === 0) continue;
  // 연속 실패하면 간격을 늘린다 (최대 10배)
  await sleep(PRICE_POLL_SECONDS * Math.min(2 ** Math.max(failures - 1, 0), 10));
}
log("종료합니다.");
