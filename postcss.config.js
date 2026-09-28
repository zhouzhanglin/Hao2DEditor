// 使用 CommonJS：main/preload 产物是 CJS，package.json 不能声明 "type": "module"
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
}
