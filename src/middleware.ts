import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";

const PUBLIC_PATHS = ["/", "/api/auth/login"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.includes(pathname)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/") && !pathname.startsWith("/api/auth/")) {
    const token = request.cookies.get("job_agent_session")?.value;
    if (!token || !(await verifySession(token))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/dashboard")) {
    const token = request.cookies.get("job_agent_session")?.value;
    if (!token || !(await verifySession(token))) {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
