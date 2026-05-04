import { punyEncode } from "@dub/utils";
import {
  decodeKeyIfCaseSensitive,
  encodeKey,
  isCaseSensitiveDomain,
} from "../api/links/case-sensitivity";
import { conn } from "./connection";
import { EdgeLinkProps, EdgeLinkWithWebhooks } from "./types";

const getLinkViaEdgeHelper = async ({
  domain,
  key,
}: {
  domain: string;
  key: string;
}): Promise<EdgeLinkWithWebhooks | null> => {
  const isCaseSensitive = isCaseSensitiveDomain(domain);
  const keyToQuery = isCaseSensitive
    ? // for case sensitive domains, we need to encode the key
      encodeKey(key)
    : // for non-case sensitive domains, we need to make sure that the key is always URI-decoded + punycode-encoded
      // (cause that's how we store it)
      punyEncode(decodeURIComponent(key));

  const { rows } =
    (await conn.execute(
      `SELECT l.*, lw."webhookId" AS "webhookId"
       FROM "Link" l
       LEFT JOIN "LinkWebhook" lw ON l.id = lw."linkId"
       WHERE l."domain" = ? AND l."key" = ?`,
      [domain, keyToQuery],
    )) || {};

  if (!rows || !Array.isArray(rows) || rows.length === 0) return null;

  const first = rows[0] as EdgeLinkProps & { webhookId: string | null };
  const { webhookId: _w, ...link } = first;
  const webhooks = (rows as (EdgeLinkProps & { webhookId: string | null })[])
    .map((r) => r.webhookId)
    .filter((id): id is string => id != null)
    .map((webhookId) => ({ webhookId }));

  return {
    ...link,
    key: decodeKeyIfCaseSensitive({ domain, key }),
    webhooks,
  };
};

const inFlightLinkLookups = new Map<
  string,
  Promise<Awaited<ReturnType<typeof getLinkViaEdgeHelper>>>
>();

export const getLinkViaEdge = async ({
  domain,
  key,
}: {
  domain: string;
  key: string;
}): Promise<Awaited<ReturnType<typeof getLinkViaEdgeHelper>>> => {
  const lookupKey = `${domain}:${key}`;
  const existingLookup = inFlightLinkLookups.get(lookupKey);

  if (existingLookup) {
    console.log(`[getLinkViaEdge] ${lookupKey} - Existing lookup found`);
    return await existingLookup;
  }

  const lookupPromise = getLinkViaEdgeHelper({ domain, key }).finally(() => {
    inFlightLinkLookups.delete(lookupKey);
  });

  inFlightLinkLookups.set(lookupKey, lookupPromise);

  return await lookupPromise;
};
