import FlowDiagram from '@/components/FlowDiagram'

export default function Home() {
  return (
    <main className="pageMain">
      <header className="pageHeader">
        <span className="pageTag">{'// Concierge Ops'}</span>
        <h1 className="pageTitle">Concierge — Live</h1>
        <span className="pageStatus">
          <span className="statusDot" />
          Realtime Feed
        </span>
      </header>
      <FlowDiagram />
    </main>
  )
}
