import React from 'react';

export default function LiquidButton({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  className = '',
  disabled = false,
}) {
  const variants = {
    primary:
      'from-cyan-400/90 to-cyan-500/70 border-cyan-300/40 shadow-[0_8px_24px_rgba(34,211,238,0.25)]',
    success:
      'from-emerald-400/85 to-teal-500/65 border-emerald-300/40 shadow-[0_8px_24px_rgba(52,211,153,0.25)]',
    danger:
      'from-rose-500/85 to-pink-600/65 border-rose-300/40 shadow-[0_8px_24px_rgba(244,63,94,0.25)]',
    ghost: 'from-white/[0.12] to-white/[0.06] border border-white/15',
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`
        group relative overflow-hidden rounded-full border px-6 py-2.5 font-medium
        text-white backdrop-blur-xl transition-all duration-300
        hover:brightness-110 active:scale-[0.97] disabled:opacity-50
        disabled:cursor-not-allowed disabled:hover:brightness-100
        bg-gradient-to-b ${variants[variant]}
        ${className}
      `}
    >
      {/* 顶部发丝高光 */}
      <span className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      {/* 液体折射 */}
      {variant !== 'ghost' && (
        <span
          className="absolute -inset-full z-0 opacity-25 transition-opacity duration-300 group-hover:opacity-40"
          style={{
            background:
              'radial-gradient(circle, rgba(255,255,255,0.45) 0%, transparent 60%)',
            animation: 'liquid 5s linear infinite',
          }}
        />
      )}
      <span className="relative z-10 flex items-center justify-center gap-2">{children}</span>
    </button>
  );
}