/// <reference types="vite/client" />

declare module '*.module.css' {
  const classes: readonly Record<string, string>;
  export default classes;
}

declare module '*.css';

declare module '*.module.scss' {
  const classes: readonly Record<string, string>;
  export default classes;
}
