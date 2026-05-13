import type postgres from "@prisma-next/postgres/runtime";
import type { Contract } from "./schema/contract.d";

export declare const prismaNext: ReturnType<typeof postgres<Contract>>;
export declare const db: typeof prismaNext;

export type { Contract } from "./schema/contract.d";
export default prismaNext;
