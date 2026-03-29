import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

const FINTUAL_AUTH_URL = "https://fintual.cl/api/users/sign_in";
const FINTUAL_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36";

const FIREBASE_API_KEY = "AIzaSyCHCBAaUWhTc8mGtyqfahJ4cYpeVACoCJk";
const FIREBASE_AUTH_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";

// Banks that can be validated server-side (API-mode, no browser needed)
const VALIDATABLE_BANKS = new Set(["fintual", "racional"]);

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { bankId, rut, password } = await req.json() as {
    bankId: string;
    rut: string;
    password: string;
  };

  if (!bankId || !rut || !password) {
    return NextResponse.json({ error: "Faltan campos" }, { status: 400 });
  }

  // Banks that require a browser can't be validated from the server
  if (!VALIDATABLE_BANKS.has(bankId)) {
    return NextResponse.json({ canValidate: false });
  }

  if (bankId === "fintual") {
    try {
      const res = await fetch(FINTUAL_AUTH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": FINTUAL_UA,
        },
        body: JSON.stringify({ user: { email: rut, password } }),
      });

      if (res.ok) {
        return NextResponse.json({ canValidate: true, valid: true });
      }

      if (res.status === 401 || res.status === 400) {
        return NextResponse.json({
          canValidate: true,
          valid: false,
          error: "Email o contraseña incorrectos",
        });
      }

      return NextResponse.json({
        canValidate: true,
        valid: false,
        error: `Error de Fintual (HTTP ${res.status})`,
      });
    } catch {
      return NextResponse.json({ canValidate: false });
    }
  }

  if (bankId === "racional") {
    try {
      const res = await fetch(`${FIREBASE_AUTH_URL}?key=${FIREBASE_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: rut, password, returnSecureToken: false }),
      });

      if (res.ok) {
        return NextResponse.json({ canValidate: true, valid: true });
      }

      const body = await res.json().catch(() => ({ error: { message: "" } })) as {
        error?: { message?: string };
      };
      const msg = body.error?.message ?? "";

      let errorText = "Email o contraseña incorrectos";
      if (msg === "EMAIL_NOT_FOUND" || msg === "INVALID_EMAIL") {
        errorText = "Email no registrado en Racional";
      } else if (msg === "TOO_MANY_ATTEMPTS_TRY_LATER") {
        errorText = "Demasiados intentos. Espera unos minutos";
      }

      return NextResponse.json({ canValidate: true, valid: false, error: errorText });
    } catch {
      return NextResponse.json({ canValidate: false });
    }
  }

  return NextResponse.json({ canValidate: false });
}
