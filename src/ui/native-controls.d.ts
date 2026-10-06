import "react";

// React 19.2 forwards these native attributes but its stable types predate them.
declare module "react" {
  interface ButtonHTMLAttributes<T> {
    commandfor?: string;
    command?: "show-modal" | "close";
  }
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string;
  }
}
