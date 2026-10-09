export default function Home() {
	return (
		<main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-3 p-8 text-center">
			<div className="h-10 w-10 animate-pulse rounded-full bg-indigo-500/80" />
			<h1 className="text-2xl font-semibold">Your app is being built</h1>
			<p className="text-zinc-500">The preview updates as the agent works.</p>
		</main>
	);
}
