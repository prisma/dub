import { DubApiError, handleAndReturnErrorResponse } from "@/lib/api/errors";
import { verifyVercelSignature } from "@/lib/cron/verify-vercel";
import { logAndRespond } from "../utils";

export const dynamic = "force-dynamic";

// PostgreSQL backups are managed by the database provider.
// Scheduled UTC: 12:40 AM, 8:40 AM, 12:40 PM, 8:40 PM (cron: 40 0,8,12,20 * * *)

export async function GET(req: Request) {
  try {
    await verifyVercelSignature(req);

    if (process.env.POSTGRES_BACKUP_WEBHOOK_URL) {
      const res = await fetch(process.env.POSTGRES_BACKUP_WEBHOOK_URL, {
        method: "POST",
      });

      if (!res.ok) {
        const bodyText = await res.text();

        throw new DubApiError({
          code: "internal_server_error",
          message: `PostgreSQL backup webhook failed (${res.status}): ${bodyText}`,
        });
      }

      return logAndRespond("Triggered PostgreSQL backup webhook.");
    }

    return logAndRespond(
      "PostgreSQL backups are managed externally; no backup webhook configured.",
    );
  } catch (error) {
    return handleAndReturnErrorResponse(error);
  }
}
