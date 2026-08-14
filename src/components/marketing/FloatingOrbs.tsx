export function FloatingOrbs() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {/* Large gradient orb - top right */}
      <div
        className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-br from-blue-200/30 to-indigo-300/20 rounded-full blur-3xl animate-pulse"
        style={{
          animation: 'float 20s ease-in-out infinite',
        }}
      />
      {/* Medium gradient orb - bottom left */}
      <div
        className="absolute bottom-0 left-0 w-72 h-72 bg-gradient-to-tr from-purple-200/30 to-pink-200/20 rounded-full blur-3xl"
        style={{
          animation: 'float 15s ease-in-out infinite reverse',
        }}
      />
      {/* Small accent orb */}
      <div
        className="absolute top-1/2 left-1/4 w-48 h-48 bg-gradient-to-r from-cyan-200/20 to-blue-200/20 rounded-full blur-2xl"
        style={{
          animation: 'float 25s ease-in-out infinite',
        }}
      />
      <style>{`
        @keyframes float {
          0%, 100% {
            transform: translate(0, 0) scale(1);
          }
          33% {
            transform: translate(30px, -30px) scale(1.1);
          }
          66% {
            transform: translate(-20px, 20px) scale(0.9);
          }
        }
      `}</style>
    </div>
  );
}
