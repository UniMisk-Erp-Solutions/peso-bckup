export function LogoStrip() {
  const logos = [
    "Ops Teams",
    "Finance",
    "Admin",
    "Multi-Branch",
    "SMEs",
    "Startups"
  ];

  return (
    <div className="py-12 border-y border-gray-200">
      <p className="text-sm text-gray-500 text-center mb-8">Trusted by teams at</p>
      <div className="flex flex-wrap items-center justify-center gap-4 md:gap-8">
        {logos.map((logo, index) => (
          <div
            key={index}
            className="px-4 py-2 bg-gray-100 rounded-full text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors"
          >
            {logo}
          </div>
        ))}
      </div>
    </div>
  );
}
