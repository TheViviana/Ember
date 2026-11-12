// 测试项目不加载 src/vite-env.d.ts，但会顺着 import 检查到 .tsx 里的 CSS Module 引用。
declare module '*.module.css' {
  const classes: readonly Record<string, string>;
  export default classes;
}
