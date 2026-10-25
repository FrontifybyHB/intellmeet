import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/shared/ui/button";
import { ErrorState } from "@/shared/ui/ErrorState";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/** A safe recovery surface for unexpected render failures. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Deliberately do not render or persist raw exception details.
    void error;
    void info;
  }

  private retry = () => this.setState({ failed: false });

  render() {
    if (this.state.failed) {
      return (
        <main className="flex min-h-svh items-center justify-center bg-background p-4">
          <ErrorState
            title="This page could not be displayed"
            message="Try again. If the problem continues, return to your meetings and retry the action."
            action={
              <Button type="button" onClick={this.retry}>
                Try again
              </Button>
            }
            className="w-full max-w-lg"
          />
        </main>
      );
    }

    return this.props.children;
  }
}
