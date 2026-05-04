import { getCustomersCountQuerySchema } from "@/lib/zod/schemas/customers";
import { sanitizeFullTextSearch } from "@dub/prisma";
import { Prisma } from "@dub/prisma/client";
import * as z from "zod/v4";

type CustomerCountFilters = z.infer<typeof getCustomersCountQuerySchema> & {
  workspaceId: string;
};

export function buildCustomerCountWhere(filters: CustomerCountFilters) {
  const {
    programId,
    partnerId,
    workspaceId,
    email,
    externalId,
    search,
    country,
    linkId,
    groupBy,
  } = filters;

  const customerWhereInput: Prisma.CustomerWhereInput = {
    ...(programId && {
      programId,
    }),
    ...(partnerId && {
      partnerId,
    }),
    projectId: workspaceId,
    ...(email
      ? { email }
      : externalId
        ? { externalId }
        : search
          ? search.includes("@")
            ? { email: search }
            : {
                OR: [
                  {
                    email: {
                      contains: sanitizeFullTextSearch(search),
                      mode: "insensitive",
                    },
                  },
                  {
                    name: {
                      contains: sanitizeFullTextSearch(search),
                      mode: "insensitive",
                    },
                  },
                ],
              }
          : {}),
    // only filter by country if not grouping by country
    ...(country &&
      groupBy !== "country" && {
        country,
      }),
    // only filter by linkId if not grouping by linkId
    ...(linkId &&
      groupBy !== "linkId" && {
        linkId,
      }),
  };

  return customerWhereInput;
}
