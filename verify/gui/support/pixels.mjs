// SPDX-License-Identifier: GPL-3.0-or-later
import { inflateSync, deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
function crc(data){let n=0xffffffff;for(const b of data){n^=b;for(let k=0;k<8;k++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([n,t,data,c]);}
export function encodePNG({width,height,rgba}){
 const h=Buffer.alloc(13);h.writeUInt32BE(width);h.writeUInt32BE(height,4);h[8]=8;h[9]=6;
 const pixels=Buffer.from(rgba);assert.equal(pixels.length,width*height*4);
 const raw=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++)pixels.copy(raw,y*(width*4+1)+1,y*width*4,(y+1)*width*4);
 return Buffer.concat([signature,chunk('IHDR',h),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export function decodePNG(bytes){
 assert(bytes.subarray(0,8).equals(signature),'Expected PNG');let width,height,channels;const parts=[];
 for(let i=8;i<bytes.length;){const n=bytes.readUInt32BE(i),type=bytes.toString('ascii',i+4,i+8),data=bytes.subarray(i+8,i+8+n);assert.equal(data.length,n,'Truncated PNG');assert.equal(bytes.readUInt32BE(i+8+n),crc(bytes.subarray(i+4,i+8+n)),'PNG CRC');
 if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert(data[8]===8&&[2,6].includes(data[9])&&data[10]===0&&data[11]===0&&data[12]===0,'Only noninterlaced 8-bit RGB/RGBA PNG supported');channels=data[9]===6?4:3;assert(width*height<=40e6,'PNG size exceeds safety limit');}
 if(type==='IDAT')parts.push(data);i+=n+12;if(type==='IEND')break;
 }
 assert(width&&height&&channels,'Missing PNG header');const stride=width*channels,raw=inflateSync(Buffer.concat(parts),{maxOutputLength:height*(stride+1)});assert.equal(raw.length,height*(stride+1));
 const pixels=Buffer.alloc(height*stride),rgba=Buffer.alloc(width*height*4);
 for(let y=0;y<height;y++){const filter=raw[y*(stride+1)];assert(filter<=4,'Unknown PNG filter');for(let x=0;x<stride;x++){const a=x>=channels?pixels[y*stride+x-channels]:0,b=y?pixels[(y-1)*stride+x]:0,c=y&&x>=channels?pixels[(y-1)*stride+x-channels]:0;
 const predictor=[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter];pixels[y*stride+x]=(raw[y*(stride+1)+1+x]+predictor)&255;}}
 for(let i=0,j=0;i<pixels.length;i+=channels,j+=4){rgba[j]=pixels[i];rgba[j+1]=pixels[i+1];rgba[j+2]=pixels[i+2];rgba[j+3]=channels===4?pixels[i+3]:255;}
 return{width,height,rgba};
}
export function comparePixels(expected,actual,{channelTolerance=12,maximumChangedFraction=.005,region,exclude=[]}={}){
 assert.equal(actual.width,expected.width,'Screenshot width mismatch');assert.equal(actual.height,expected.height,'Screenshot height mismatch');
 assert(channelTolerance>=0&&channelTolerance<=255&&maximumChangedFraction>=0&&maximumChangedFraction<=1);
 const area=region??{x:0,y:0,width:actual.width,height:actual.height};
 assert([area.x,area.y,area.width,area.height].every(Number.isInteger)&&area.x>=0&&area.y>=0&&area.width>0&&area.height>0&&area.x+area.width<=actual.width&&area.y+area.height<=actual.height,'Invalid comparison region');
 const diff=Buffer.alloc(actual.rgba.length);let changed=0,count=0,error=0;
 for(let y=area.y;y<area.y+area.height;y++)for(let x=area.x;x<area.x+area.width;x++){
 if(exclude.some(r=>x>=r.x&&y>=r.y&&x<r.x+r.width&&y<r.y+r.height))continue;
 const i=(y*actual.width+x)*4;let max=0;for(let c=0;c<4;c++){const d=Math.abs(expected.rgba[i+c]-actual.rgba[i+c]);error+=d;max=Math.max(max,d);}count++;
 if(max>channelTolerance){changed++;diff[i]=255;diff[i+3]=255;}else{diff[i+1]=actual.rgba[i+1]/3;diff[i+3]=255;}}
 assert(count>0,'Comparison masks all pixels');const fraction=changed/count;
 return{pass:fraction<=maximumChangedFraction,changed,count,fraction,meanAbsoluteError:error/count/4,channelTolerance,maximumChangedFraction,diff:{width:actual.width,height:actual.height,rgba:diff}};
}
