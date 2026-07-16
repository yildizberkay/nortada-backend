// TEMPORARY one-shot cleanup for the PNG→WebP container switch (2026-07-16).
// Deletes every weather-map PNG from R2 (INCLUDING orphans no DB row points
// at) and every weather_map_frame row whose object key still ends in .png —
// the renderer then re-renders those hours as WebP on its next tick.
// DELETE THIS FILE once the purge has run in prod.
//
//   npx tsx --env-file=.env tools/purge-weathermap-png.ts            # dry run
//   npx tsx --env-file=.env tools/purge-weathermap-png.ts --apply    # delete
//
// Credentials come from the same env the API uses (OBJECT_STORAGE_* +
// DATABASE_URL); nothing is read from code.

import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { weatherMapFrameTable } from "../src/db/schema";

const apply = process.argv.includes("--apply");

const bucket = process.env.OBJECT_STORAGE_BUCKET;
if (!bucket) throw new Error("OBJECT_STORAGE_BUCKET is not set");

const s3 = new S3Client({
  region: process.env.OBJECT_STORAGE_REGION ?? "auto",
  ...(process.env.OBJECT_STORAGE_ENDPOINT
    ? { endpoint: process.env.OBJECT_STORAGE_ENDPOINT }
    : {}),
  ...(process.env.OBJECT_STORAGE_FORCE_PATH_STYLE === "true"
    ? { forcePathStyle: true }
    : {}),
  ...(process.env.OBJECT_STORAGE_ACCESS_KEY_ID &&
  process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
          secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});

async function listPngKeys(): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "weather-map/",
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key?.endsWith(".png")) keys.push(object.Key);
    }
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return keys;
}

async function deleteKeys(keys: string[]): Promise<void> {
  // DeleteObjects caps at 1000 keys per request.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    if (result.Errors?.length) {
      for (const err of result.Errors) {
        console.error(`  ! ${err.Key}: ${err.Code} ${err.Message}`);
      }
      throw new Error(`${result.Errors.length} object deletes failed`);
    }
    console.log(`  deleted ${Math.min(i + 1000, keys.length)}/${keys.length}`);
  }
}

async function main() {
  console.log(`bucket=${bucket} mode=${apply ? "APPLY" : "dry-run"}\n`);

  const keys = await listPngKeys();
  console.log(`R2: ${keys.length} weather-map .png object(s)`);
  for (const key of keys.slice(0, 10)) console.log(`  ${key}`);
  if (keys.length > 10) console.log(`  … +${keys.length - 10} more`);

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  const rows = await db
    .select({ id: weatherMapFrameTable.id, key: weatherMapFrameTable.objectKey })
    .from(weatherMapFrameTable)
    .where(like(weatherMapFrameTable.objectKey, "%.png"));
  console.log(`DB: ${rows.length} weather_map_frame row(s) with .png keys`);

  if (!apply) {
    console.log("\nDry run — re-run with --apply to delete.");
    await pool.end();
    return;
  }

  if (keys.length > 0) {
    console.log("\nDeleting R2 objects…");
    await deleteKeys(keys);
  }
  if (rows.length > 0) {
    console.log("Deleting DB rows…");
    await db
      .delete(weatherMapFrameTable)
      .where(like(weatherMapFrameTable.objectKey, "%.png"));
  }
  await pool.end();
  console.log(
    "\nDone. The renderer re-renders these hours as WebP on its next tick.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
