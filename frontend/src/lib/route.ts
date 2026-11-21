import { useEffect, useState } from "react";

/** 화면 구분. 주소창 해시(#oracle)로 정해서 새로고침해도 유지되고 링크로 공유할 수 있다. */
export type Route = "lend" | "oracle";

const read = (): Route => (window.location.hash === "#oracle" ? "oracle" : "lend");

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const routeHref = (route: Route) => (route === "oracle" ? "#oracle" : "#");
