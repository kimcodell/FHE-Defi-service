/** MetaMask 같은 브라우저 지갑(window.ethereum)이 설치돼 있는지 */
export const hasBrowserWallet = () => typeof window !== "undefined" && "ethereum" in window;
