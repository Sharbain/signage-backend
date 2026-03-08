ALTER TABLE "device_commands" ALTER COLUMN "executed" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "screens" ALTER COLUMN "token_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "device_commands" ADD COLUMN "sent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "device_commands" ADD COLUMN "executed_at" timestamp;--> statement-breakpoint
ALTER TABLE "screens" DROP COLUMN "pairing_code";