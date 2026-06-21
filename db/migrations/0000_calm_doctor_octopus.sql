CREATE TABLE "bots" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"guesses" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"harvested" integer DEFAULT 0 NOT NULL,
	"room" text DEFAULT '' NOT NULL,
	"since" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawings" (
	"id" serial PRIMARY KEY NOT NULL,
	"word" text NOT NULL,
	"drawing" jsonb NOT NULL,
	"colors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ops" jsonb,
	"bot" text DEFAULT '' NOT NULL,
	"ts" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "drawings_word_idx" ON "drawings" USING btree ("word");--> statement-breakpoint
CREATE INDEX "drawings_ts_idx" ON "drawings" USING btree ("ts");