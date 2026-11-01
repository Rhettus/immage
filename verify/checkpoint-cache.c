// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

#include "common/darktable.h"
#include "develop/pixelpipe_hb.h"
#include "develop/format.h"
#include <stdio.h>

#define REQUIRE(test) do { if(!(test)) { fprintf(stderr, "failed: %s\n", #test); return 1; } } while(0)

static void *put(dt_dev_pixelpipe_t *pipe, dt_hash_t hash)
{
  dt_iop_buffer_dsc_t format = { 0 }, *dsc = &format;
  void *data = NULL;
  dt_dev_pixelpipe_cache_get(pipe, hash, 64, &data, &dsc, NULL, FALSE);
  return data;
}

static void churn(dt_dev_pixelpipe_t *pipe, dt_hash_t first)
{
  for(dt_hash_t hash = first; hash < first + 256; hash++) put(pipe, hash);
}

int main(void)
{
  dt_dev_pixelpipe_t pipe = { .type = DT_DEV_PIXELPIPE_FULL };
  REQUIRE(dt_dev_pixelpipe_cache_init(&pipe, 16, 0, 1));
  // three preview geometries survive far more allocations than the cache can hold
  for(dt_hash_t hash = 1; hash <= 3; hash++)
  {
    void *data = put(&pipe, hash);
    REQUIRE(data);
    memset(data, (int)hash, 64);
    dt_dev_pixelpipe_retain_checkpoint(&pipe, data, 64);
  }
  churn(&pipe, 1000);
  for(dt_hash_t hash = 1; hash <= 3; hash++)
  {
    REQUIRE(dt_dev_pixelpipe_cache_available(&pipe, hash, 64));
    const unsigned char *data = put(&pipe, hash);
    for(int i = 0; i < 64; i++) REQUIRE(data[i] == hash);
  }
  // a fourth geometry drops the oldest protection; recently touched ones survive
  dt_dev_pixelpipe_retain_checkpoint(&pipe, put(&pipe, 1), 64);
  dt_dev_pixelpipe_retain_checkpoint(&pipe, put(&pipe, 4), 64);
  churn(&pipe, 2000);
  REQUIRE(dt_dev_pixelpipe_cache_available(&pipe, 1, 64));
  REQUIRE(!dt_dev_pixelpipe_cache_available(&pipe, 2, 64));
  REQUIRE(dt_dev_pixelpipe_cache_available(&pipe, 3, 64));
  REQUIRE(dt_dev_pixelpipe_cache_available(&pipe, 4, 64));
  // upstream invalidation and low-memory trimming still reclaim retained buffers
  dt_dev_pixelpipe_invalidate_cacheline(&pipe, put(&pipe, 3), NULL);
  REQUIRE(!dt_dev_pixelpipe_cache_available(&pipe, 3, 64));
  churn(&pipe, 3000);
  int fractions[4] = { 0 };
  darktable.dtresources.fractions = fractions;
  dt_dev_pixelpipe_cache_checkmem(&pipe, TRUE);
  REQUIRE(!dt_dev_pixelpipe_cache_available(&pipe, 1, 64));
  REQUIRE(!dt_dev_pixelpipe_cache_available(&pipe, 4, 64));
  dt_dev_pixelpipe_cache_flush(&pipe);
  dt_dev_pixelpipe_cache_cleanup(&pipe);
  // the two-buffer fallback must not try to retain its swapping buffers
  memset(&pipe, 0, sizeof(pipe));
  REQUIRE(dt_dev_pixelpipe_cache_init(&pipe, DT_PIPECACHE_MIN, 64, 1));
  dt_dev_pixelpipe_retain_checkpoint(&pipe, put(&pipe, 1), 64);
  churn(&pipe, 4000);
  REQUIRE(!dt_dev_pixelpipe_cache_available(&pipe, 1, 64));
  dt_dev_pixelpipe_cache_cleanup(&pipe);
  puts("checkpoint retention: churn, bounded replacement, invalidation, memory trim and two-buffer fallback passed");
  return 0;
}
