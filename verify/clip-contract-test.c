// SPDX-License-Identifier: GPL-3.0-or-later
// Headless: cc -std=c99 -Wall -Wextra -Werror verify/clip-contract-test.c -lm -o /tmp/immage-clip-contract && /tmp/immage-clip-contract
#include "../engine/clip_contract.h"
#include <assert.h>
#include <float.h>
int main(void)
{
  int64_t declared[4] = {-1,512,1,1}, shape[4] = {0};
  assert(clip_output_shape(false,"text_embeds",2,declared,shape));
  assert(shape[0]==1 && shape[1]==512);
  assert(!clip_output_shape(true,"text_embeds",2,declared,shape));
  assert(!clip_output_shape(false,"text_embeds",3,declared,shape));
  assert(!clip_output_shape(false,"unknown",2,declared,shape));
  declared[1]=513;assert(!clip_output_shape(false,"text_embeds",2,declared,shape));
  declared[0]=2;declared[1]=512;assert(!clip_output_shape(false,"text_embeds",2,declared,shape));
  declared[0]=1;declared[1]=-1;declared[2]=768;
  assert(clip_output_shape(true,"last_hidden_state",3,declared,shape));
  assert(shape[1]==50 && shape[2]==768);
  assert(!clip_output_shape(false,"last_hidden_state",3,declared,shape));
  assert(!clip_output_shape(true,"last_hidden_state",4,declared,shape));
  float vector[512]={0};assert(!clip_normalize(vector));
  vector[0]=NAN;assert(!clip_normalize(vector));
  vector[0]=INFINITY;assert(!clip_normalize(vector));
  vector[0]=FLT_MAX;vector[1]=FLT_MAX;
  assert(clip_normalize(vector));assert(fabs(vector[0]-sqrt(0.5))<1e-6);
  vector[0]=3;vector[1]=4;
  assert(clip_normalize(vector));assert(fabs(vector[0]-0.6)<1e-6 && fabs(vector[1]-0.8)<1e-6);
  return 0;
}
