import { auth } from "@/lib/auth";
import { supabase } from "@/lib/db";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { data, error } = await supabase
      .from("users")
      .select("gmail_refresh_token, agentic_mode")
      .eq("id", session.user.id)
      .single();

    if (error) {
      // Columns may not exist yet — treat as disconnected
      return Response.json({ connected: false, agenticMode: false });
    }

    return Response.json({
      connected: !!data?.gmail_refresh_token,
      agenticMode: !!data?.agentic_mode,
    });
  } catch {
    return Response.json({ connected: false, agenticMode: false });
  }
}
