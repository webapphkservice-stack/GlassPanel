import React from 'react';
import { createPortal } from 'react-dom';
import { X } from './Icons';

export default function GlassModal({ title, subtitle, children, onClose, open, maxWidth = 'max-w-2xl' }) {
  if (!open) return null;
  // 通过 Portal 挂到 body：避免祖先元素（如带 backdrop-filter 的顶栏）成为
  // fixed 定位的包含块，导致弹窗被挤到视口外、标题与关闭按钮点不到
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-md animate-[fadeIn_0.2s_ease]"
        onClick={onClose}
      />
      <div className={`relative z-10 flex max-h-[calc(100vh-2rem)] w-full ${maxWidth} overflow-hidden rounded-3xl border border-white/[0.12] shadow-glass backdrop-blur-2xl backdrop-saturate-150 bg-gradient-to-b from-white/[0.12] via-white/[0.06] to-white/[0.09] p-px animate-[scaleIn_0.22s_cubic-bezier(0.16,1,0.3,1)]`}>
        {/* 顶缘高光 */}
        <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        <div className="relative flex max-h-full w-full flex-col overflow-hidden rounded-[calc(1.5rem-1px)] bg-gray-950/70 backdrop-blur-2xl backdrop-saturate-150">
          {/* 标题区 */}
          <div className="flex flex-none items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
            <div className="flex items-start gap-3">
              <span className="mt-1 h-6 w-1.5 rounded-full bg-gradient-to-b from-cyan-400 to-cyan-500" />
              <div>
                <h3 className="text-xl font-semibold">{title}</h3>
                {subtitle && <p className="mt-1 text-sm text-white/50">{subtitle}</p>}
              </div>
            </div>
            <button
              onClick={onClose}
              className="rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white transition-all"
              aria-label="关闭"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
          <style>{`
            @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
            @keyframes scaleIn { from { opacity: 0; transform: scale(0.96) translateY(8px) } to { opacity: 1; transform: scale(1) translateY(0) } }
          `}</style>
        </div>
      </div>
    </div>,
    document.body
  );
}
