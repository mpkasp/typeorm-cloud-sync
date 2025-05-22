const fs = require('fs');

const packageName = process.env.npm_package_name;
const packageVersion = process.env.npm_package_version;
const oldFileName = `${packageName}-${packageVersion}.tgz`;
const newFileName = `${packageName}.tgz`; // Include version in new name

fs.copyFile(oldFileName, newFileName, (err) => {
  if (err) throw err;
  console.log(`File successfully copied package to ${newFileName}!`);
});
