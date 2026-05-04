import { Prisma } from "@dub/prisma/client";
import {
  addDays,
  addHours,
  addMinutes,
  addMonths,
  startOfDay,
  startOfHour,
  startOfMinute,
  startOfMonth,
} from "date-fns";

export const sqlGranularityMap: Record<
  string,
  {
    dateFormat: string;
    dateIncrement: (dt: Date) => Date;
    startFunction: (dt: Date) => Date;
    formatString: string;
  }
> = {
  month: {
    dateFormat: "YYYY-MM",
    dateIncrement: (dt) => addMonths(dt, 1),
    startFunction: (dt) => startOfMonth(dt),
    formatString: "yyyy-MM",
  },
  day: {
    dateFormat: "YYYY-MM-DD",
    dateIncrement: (dt) => addDays(dt, 1),
    startFunction: (dt) => startOfDay(dt),
    formatString: "yyyy-MM-dd",
  },
  hour: {
    dateFormat: "YYYY-MM-DD HH24:00",
    dateIncrement: (dt) => addHours(dt, 1),
    startFunction: (dt) => startOfHour(dt),
    formatString: "yyyy-MM-dd HH:00",
  },
  minute: {
    dateFormat: "YYYY-MM-DD HH24:MI",
    dateIncrement: (dt) => addMinutes(dt, 1),
    startFunction: (dt) => startOfMinute(dt),
    formatString: "yyyy-MM-dd HH:mm",
  },
} as const;

export const pgDateBucket = ({
  column,
  timezone = "UTC",
  dateFormat,
}: {
  column: Prisma.Sql;
  timezone?: string;
  dateFormat: string;
}) =>
  Prisma.sql`to_char(${column} AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}, ${dateFormat})`;
