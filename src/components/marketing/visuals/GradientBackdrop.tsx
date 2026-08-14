export function GradientBackdrop() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <div className="absolute inset-0 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950" />
      <div className="absolute top-0 right-0 w-[80vw] max-w-[1200px] h-[70vh] bg-blue-500/10 rounded-full blur-[120px]" />
      <div className="absolute bottom-0 left-0 w-[60vw] max-w-[900px] h-[50vh] bg-indigo-500/10 rounded-full blur-[100px]" />
      <div className="absolute top-1/3 left-1/2 w-[40vw] h-[40vw] max-w-[500px] max-h-[500px] bg-violet-500/5 rounded-full blur-[80px]" />
    </div>
  );
}
