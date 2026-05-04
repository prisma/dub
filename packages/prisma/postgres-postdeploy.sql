-- PostgreSQL indexes and extensions Prisma schema cannot express on 6.19.x.
-- Run this after `prisma db push` or after applying production DDL.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Customer_email_trgm_idx"
  ON "Customer" USING gin ("email" gin_trgm_ops)
  WHERE "email" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Customer_name_trgm_idx"
  ON "Customer" USING gin ("name" gin_trgm_ops)
  WHERE "name" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Partner_email_trgm_idx"
  ON "Partner" USING gin ("email" gin_trgm_ops)
  WHERE "email" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Partner_name_trgm_idx"
  ON "Partner" USING gin ("name" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Partner_companyName_trgm_idx"
  ON "Partner" USING gin ("companyName" gin_trgm_ops)
  WHERE "companyName" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "PartnerReferral_email_trgm_idx"
  ON "PartnerReferral" USING gin ("email" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "PartnerReferral_name_trgm_idx"
  ON "PartnerReferral" USING gin ("name" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Link_url_trgm_idx"
  ON "Link" USING gin ("url" gin_trgm_ops);
