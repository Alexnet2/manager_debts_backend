const sharp = require('sharp');
(async () => {
  const buf = require('fs').readFileSync('verify_crop_seg.png');
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  console.log('crop:', info.width, info.height, info.channels);
})();
