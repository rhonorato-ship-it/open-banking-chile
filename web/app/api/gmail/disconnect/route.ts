import { auth } from "@/lib/auth";
import { disconnectGmail } from "@/lib/gmail";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await disconnectGmail(session.user.id);
    return Response.json({ ok: true });
  } catch (e) {
    console.error("[gmail/disconnect] error:", e);
    return Response.json({ error: "Failed to disconnect" }, { status: 500 });
  }
}
