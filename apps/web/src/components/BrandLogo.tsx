import type { ImgHTMLAttributes } from "react";

export type BrandLogoVariant = "mark" | "wordmark";

interface BrandLogoProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> {
  variant?: BrandLogoVariant;
}

export function BrandLogo({ variant = "mark", className = "", ...props }: BrandLogoProps) {
  const isWordmark = variant === "wordmark";

  return (
    <img
      {...props}
      src={isWordmark ? "/logo.png" : "/logo2.png"}
      alt={isWordmark ? "KaziOS — Business Operating System" : "KaziOS icon mark"}
      className={`${isWordmark ? "kazi-brand-wordmark" : "kazi-brand-mark"} ${className}`.trim()}
      decoding="async"
    />
  );
}
