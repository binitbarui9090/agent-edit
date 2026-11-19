import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

function classes(variant: Variant, extra?: string) {
  return [styles.button, styles[variant], extra].filter(Boolean).join(' ');
}

export function Button({
  variant = 'secondary',
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type={type} className={classes(variant, className)} {...rest} />;
}

export function ButtonLink({
  variant = 'secondary',
  className,
  ...rest
}: LinkProps & { variant?: Variant }) {
  return <Link className={classes(variant, className)} {...rest} />;
}

/** A square icon control. Its label is both the accessible name and the tooltip. */
export function IconButton({
  icon: Icon,
  label,
  shortcut,
  active,
  size = 16,
  tipSide = 'top',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  active?: boolean;
  size?: number;
  tipSide?: 'top' | 'bottom' | 'left' | 'right';
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={shortcut ? `${label}  ${shortcut}` : label}
      data-tip-side={tipSide}
      data-active={active || undefined}
      className={[styles.icon, className].filter(Boolean).join(' ')}
      {...rest}
    >
      <Icon size={size} strokeWidth={1.75} aria-hidden="true" />
      {children}
    </button>
  );
}
