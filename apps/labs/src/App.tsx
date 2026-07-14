const CONTACT_EMAIL = 'hello@superpositionlabs.co.in';

interface Product {
  name: string;
  description: string;
  href?: string;
}

const products: Product[] = [
  {
    name: 'plate-clean',
    description:
      'A PWA that rewards restaurant diners for finishing their plates. Cuts kitchen waste, brings diners back. Live pilot in Mumbai.',
    href: 'https://about.plateclean.in',
  },
  {
    name: 'in the works',
    description: 'More coming. Currently focused on the Plate-Clean pilot.',
  },
];

export function App() {
  return (
    <div className="min-h-screen bg-white text-ink">
      <div className="mx-auto w-full max-w-[640px] px-6">
        <header className="flex items-center justify-between pt-8">
          <span className="text-[20px] font-light tracking-tight text-ink">
            Superposition Labs
          </span>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-[14px] text-ink no-underline transition-colors hover:text-accent hover:underline"
          >
            {CONTACT_EMAIL}
          </a>
        </header>

        <section className="flex min-h-[40vh] flex-col justify-center py-24">
          <h1 className="text-[44px] font-light leading-[1.05] tracking-tight text-ink sm:text-[56px]">
            Superposition Labs
          </h1>
          <p className="mt-6 text-[28px] font-light leading-[1.25] text-ink">
            Data, AI, and ML systems for real-world sustainability.
          </p>
        </section>

        <section className="py-16">
          <p className="max-w-[500px] text-[16px] leading-[1.65] text-neutral-800">
            We are a Mumbai-based studio applying data science, machine
            learning, and analytics to sustainability problems worth solving.
            Small tools, real deployments, honest numbers.
          </p>
        </section>

        <section className="py-16">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.1em] text-neutral-500">
            Current work
          </h2>

          <div className="mt-8 flex flex-col gap-4">
            {products.map((product) => (
              <ProductCard key={product.name} product={product} />
            ))}
          </div>
        </section>

        <footer className="mt-24 pb-12 text-center text-[12px] text-neutral-500">
          © 2026 Superposition Labs. Mumbai, India.
        </footer>
      </div>
    </div>
  );
}

function ProductCard({ product }: { product: Product }) {
  const isPlaceholder = !product.href;

  if (isPlaceholder) {
    return (
      <div className="border border-neutral-200 px-6 py-5">
        <div className="font-mono text-[18px] font-bold text-neutral-400">
          {product.name}
        </div>
        <p className="mt-2 text-[15px] leading-[1.6] text-neutral-400">
          {product.description}
        </p>
      </div>
    );
  }

  return (
    <a
      href={product.href}
      target="_blank"
      rel="noreferrer noopener"
      className="group block border border-neutral-200 px-6 py-5 no-underline transition-colors hover:border-ink"
    >
      <div className="flex items-baseline justify-between font-mono text-[18px] font-bold text-ink">
        <span>{product.name}</span>
        <span
          aria-hidden="true"
          className="translate-x-0 text-accent opacity-0 transition-all duration-200 group-hover:translate-x-1 group-hover:opacity-100"
        >
          →
        </span>
      </div>
      <p className="mt-2 text-[15px] leading-[1.6] text-neutral-700">
        {product.description}
      </p>
    </a>
  );
}
