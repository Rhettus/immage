import test from "node:test";
import assert from "node:assert/strict";
import { FolderEdits } from "../app/src/folderEdits.ts";

test("rejection survives later batches and the final stale folder reply", () => {
  const edits = new FolderEdits();
  const first = { imgid: 1, rejected: false, rating: 0, labels: 0 };
  edits.patch(1, { rejected: true });
  const second = { imgid: 2, rejected: false, rating: 0, labels: 0 };
  assert.equal(edits.apply([first, second])[0].rejected, true);
  // The final reply was accumulated independently of the displayed batches.
  assert.equal(edits.apply([{ ...first }, { ...second }])[0].rejected, true);
  assert.equal(edits.apply([first, second])[1], second);
});

test("latest changes win per field while fresh read metadata is retained", () => {
  const edits = new FolderEdits();
  edits.patch(1, { rejected: true });
  edits.patch(1, { rating: 4, rejected: false });
  edits.patch(1, { labels: 2 });
  assert.deepEqual(edits.apply([{ imgid: 1, rejected: true, rating: 0, labels: 0, width: 6000 }]),
    [{ imgid: 1, rejected: false, rating: 4, labels: 2, width: 6000 }]);
  // A later folder read must see external changes rather than keep this overlay.
  assert.equal(new FolderEdits().apply([{ imgid: 1, rejected: true }])[0].rejected, true);
});
