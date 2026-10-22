ALTER TABLE "topics" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_status_valid" CHECK ("topics"."status" IN ('active','archived'));