import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
export async function GET() {
  const session = await auth();
  return NextResponse.json({ userId: session?.user?.id, email: session?.user?.email });
}
