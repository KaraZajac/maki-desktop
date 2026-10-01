import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, Card, Label } from './ui'

/**
 * A part of the window that broke, said so where it was, rather than the whole window gone. The
 * link lives above it, and with it what the browser, ssh, gpg and age ask maki for: they carry
 * on while one page is broken.
 */
export class ErrorBoundary extends Component<
  { name: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.name} broke: ${error.message}`, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <Card className="space-y-3">
        <Label>{this.props.name}</Label>
        <p className="text-sm text-subtext1">
          Something here went wrong, and it’s been put aside. maki and the rest of maki desktop
          carry on.
        </p>
        <p className="font-mono text-[0.72rem] text-red">{error.message}</p>
        <Button kind="primary" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </Card>
    )
  }
}
