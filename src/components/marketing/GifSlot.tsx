interface GifSlotProps {
  src?: string;
  alt?: string;
  className?: string;
}

export function GifSlot({ src, alt = "Demo animation", className = "" }: GifSlotProps) {
  if (src) {
    return (
      <div className={`rounded-xl overflow-hidden shadow-xl ${className}`}>
        <img src={src} alt={alt} loading="lazy" decoding="async" className="w-full h-auto" />
      </div>
    );
  }

  // Animated gradient placeholder
  return (
    <div className={`rounded-xl overflow-hidden shadow-xl bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 ${className}`}>
      <div className="relative h-64 flex items-center justify-center">
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer"></div>
        <div className="relative text-center p-8">
          <div className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-blue-400 to-indigo-500 rounded-lg animate-pulse"></div>
          <p className="text-sm text-gray-600 font-medium">Demo animation coming soon</p>
        </div>
      </div>
      <style>{`
        @keyframes shimmer {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(100%);
          }
        }
        .animate-shimmer {
          animation: shimmer 3s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
