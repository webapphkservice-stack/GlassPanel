import React from 'react';

export default function GlassCard({ children, className = '', hover = true }) {
  return (
    <div
      className={`
        relative rounded-2xl border border-white/[0.12] shadow-glass glass-surface
        backdrop-blur-glass backdrop-saturate-150 p-6 transition-all duration-300
        ${hover ? 'glass-surface-hover hover:border-white/[0.2] hover:-translate-y-1' : ''}
        ${className}
      `}
    >
      <div
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.09), transparent 38%)',
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}