import { conn } from "./connection";

interface QueryResult {
  id: string;
  name: string;
  image: string | null;
  discountId: string;
  amount: number;
  type: "percentage" | "flat";
  maxDuration: number | null;
  couponId: string | null;
  couponTestId: string | null;
  groupId: string | null;
  tenantId: string | null;
}

// Get enrollment info for a partner in a program
export const getPartnerEnrollmentInfo = async ({
  partnerId,
  programId,
}: {
  partnerId: string | null;
  programId: string | null;
}) => {
  if (!partnerId || !programId) {
    return {
      partner: null,
      discount: null,
    };
  }

  const { rows } = await conn.execute<QueryResult>(
    `SELECT 
      p.id,
      p.name,
      p.image,
      d.id as "discountId",
      d.amount,
      d.type,
      d."maxDuration",
      d."couponId",
      d."couponTestId",
      pe."groupId",
      pe."tenantId"
    FROM "ProgramEnrollment" pe
    LEFT JOIN "Partner" p ON p.id = pe."partnerId"
    LEFT JOIN "Discount" d ON d.id = pe."discountId"
    WHERE pe."partnerId" = ? AND pe."programId" = ? LIMIT 1`,
    [partnerId, programId],
  );

  const result =
    rows && Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

  if (!result) {
    return {
      partner: null,
      discount: null,
    };
  }

  return {
    partner: {
      id: result.id,
      name: result.name,
      image: result.image,
      groupId: result.groupId,
      tenantId: result.tenantId,
    },
    discount: result.discountId
      ? {
          id: result.discountId,
          amount: result.amount,
          type: result.type,
          maxDuration: result.maxDuration,
          couponId: result.couponId,
          couponTestId: result.couponTestId,
        }
      : null,
  };
};
