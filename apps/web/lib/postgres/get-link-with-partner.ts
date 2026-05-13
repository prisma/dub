import { punyEncode } from "@dub/utils";
import {
  decodeKeyIfCaseSensitive,
  encodeKey,
  isCaseSensitiveDomain,
} from "../api/links/case-sensitivity";
import { conn } from "./connection";
import { EdgeLinkProps } from "./types";

interface QueryResult extends EdgeLinkProps {
  partner?: {
    id: string;
    name: string;
    image: string | null;
  } | null;
  discount?: {
    id: string;
    amount: number;
    type: "percentage" | "flat";
    maxDuration: number | null;
  } | null;
}

export const getLinkWithPartner = async ({
  domain,
  key,
}: {
  domain: string;
  key: string;
}): Promise<QueryResult | null> => {
  const keyToQuery = isCaseSensitiveDomain(domain)
    ? encodeKey(key)
    : punyEncode(decodeURIComponent(key));

  console.time("getLinkWithPartner");

  const { rows } =
    (await conn.execute(
      `SELECT 
        l.*,
        p.id as "partnerId",
        p.name as "partnerName",
        p.image as "partnerImage",
        pe."groupId" as "groupId",
        pe."tenantId" as "tenantId",
        d.id as "discountId",
        d.amount as "discountAmount",
        d.type as "discountType",
        d."maxDuration" as "discountMaxDuration",
        d."couponId" as "discountCouponId",
        d."couponTestId" as "discountCouponTestId"
       FROM "Link" l
       LEFT JOIN "ProgramEnrollment" pe ON pe."programId" = l."programId" AND pe."partnerId" = l."partnerId"
       LEFT JOIN "Partner" p ON p.id = pe."partnerId"
       LEFT JOIN "Discount" d ON pe."discountId" = d.id
       LEFT JOIN "Program" pg ON pg.id = l."programId"
       WHERE l."domain" = ? AND l."key" = ?`,
      [domain, keyToQuery],
    )) || {};

  console.timeEnd("getLinkWithPartner");

  const link =
    rows && Array.isArray(rows) && rows.length > 0 ? (rows[0] as any) : null;

  if (!link) {
    return null;
  }

  const {
    partnerId,
    partnerName,
    partnerImage,
    groupId,
    tenantId,
    discountId,
    discountAmount,
    discountType,
    discountMaxDuration,
    discountCouponId,
    discountCouponTestId,
    ...rest
  } = link;

  return {
    ...rest,
    partnerId,
    key: decodeKeyIfCaseSensitive({ domain, key }),
    partner: partnerId
      ? {
          id: partnerId,
          name: partnerName,
          image: partnerImage,
          groupId,
          tenantId,
        }
      : null,
    discount:
      discountId && discountAmount
        ? {
            id: discountId,
            amount: discountAmount,
            type: discountType,
            maxDuration: discountMaxDuration,
            couponId: discountCouponId,
            couponTestId: discountCouponTestId,
          }
        : null,
  };
};
