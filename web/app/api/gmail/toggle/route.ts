import { auth } from "@/lib/auth";
import { supabase } from "@/lib/db";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });

  const { enabled } = await req.json();

  const { error } = await supabase
    .from("users")
    .update({ agentic_mode: !!enabled })
    .eq("id", session.user.id);

  if (error) {
    console.error("[gmail/toggle] update error:", error);
    return new Response("Error updating agentic mode", { status: 500 });
  }

  return Response.json({ ok: true });
}
