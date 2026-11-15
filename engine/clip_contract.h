// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <math.h>

// These are the only supported outputs of the pinned CLIP projection towers.
// Dynamic dimensions are replaced with this request's batch-one dimensions.
static inline bool clip_output_shape(const bool vision, const char *name, const int rank,
                                     const int64_t *declared, int64_t *shape)
{
  int64_t expected[3] = { 1, 512, 0 };
  int dimensions = 2;
  if(!name) return false;
  if(!strcmp(name, "last_hidden_state"))
  {
    dimensions = 3;
    expected[1] = vision ? 50 : 77;
    expected[2] = vision ? 768 : 512;
  }
  else if(!strcmp(name, "pooler_output")) expected[1] = vision ? 768 : 512;
  else if(strcmp(name, vision ? "image_embeds" : "text_embeds")) return false;
  if(rank != dimensions) return false;
  for(int i = 0; i < dimensions; i++)
  {
    if(declared[i] != -1 && declared[i] != expected[i]) return false;
    shape[i] = expected[i];
  }
  return true;
}
static inline bool clip_normalize(float *embedding)
{
  double squared = 0.0;
  for(int i = 0; i < 512; i++)
  {
    if(!isfinite(embedding[i])) return false;
    squared += (double)embedding[i] * embedding[i];
  }
  if(!(squared > 0.0) || !isfinite(squared)) return false;
  const double length = sqrt(squared);
  for(int i = 0; i < 512; i++) embedding[i] = embedding[i] / length;
  return true;
}
