import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const session = await auth();
  return NextResponse.json({
    session: session
      ? {
          user: {
            id: session.user?.id,
            email: session.user?.email,
            name: session.user?.name,
          },
          expires: session.expires,
        }
      : null,
  });
}
