export function imageDimensions(bytes,mime){
 let width,height;
 if(mime==='image/png'&&bytes.length>=24){width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);}
 if(mime==='image/gif'&&bytes.length>=10){width=bytes.readUInt16LE(6);height=bytes.readUInt16LE(8);}
 if(mime==='image/jpeg'){
  let p=2;
  while(p+8<bytes.length&&p<1048576){
   if(bytes[p++]!==255)continue;const marker=bytes[p++];if(marker===216||marker===217||marker===0||marker===255)continue;
   const length=bytes.readUInt16BE(p);if(length<2)break;
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){height=bytes.readUInt16BE(p+3);width=bytes.readUInt16BE(p+5);break;}
   p+=length;
  }
 }
 if(mime==='image/webp'&&bytes.length>=30){
  const kind=bytes.subarray(12,16).toString();
  if(kind==='VP8X'){width=1+bytes.readUIntLE(24,3);height=1+bytes.readUIntLE(27,3);}
  if(kind==='VP8 '&&bytes[23]===157&&bytes[24]===1&&bytes[25]===42){width=bytes.readUInt16LE(26)&16383;height=bytes.readUInt16LE(28)&16383;}
  if(kind==='VP8L'&&bytes[20]===47){const bits=bytes.readUInt32LE(21);width=1+(bits&16383);height=1+((bits>>>14)&16383);}
 }
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192||width*height>32000000)throw new Error('图片尺寸无效或超过 8192 边长 / 3200 万像素');
 return {width,height};
}
