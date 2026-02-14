import "@/index.css"
import { ErrorBoundary, Show, Switch, Match, lazy, type ParentProps } from "solid-js"
import { Router, Route, Navigate } from "@solidjs/router"
import { MetaProvider } from "@solidjs/meta"
import { Font } from "@opencode-ai/ui/font"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { DiffComponentProvider } from "@opencode-ai/ui/context/diff"
import { CodeComponentProvider } from "@opencode-ai/ui/context/code"
import { Diff } from "@opencode-ai/ui/diff"
import { Code } from "@opencode-ai/ui/code"
import { ThemeProvider } from "@opencode-ai/ui/theme"
import { GlobalSyncProvider } from "@/context/global-sync"
import { PermissionProvider } from "@/context/permission"
import { LayoutProvider } from "@/context/layout"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { ServerProvider, useServer } from "@/context/server"
import { TerminalProvider } from "@/context/terminal"
import { PromptProvider } from "@/context/prompt"
import { FileProvider } from "@/context/file"
import { NotificationProvider } from "@/context/notification"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { CommandProvider } from "@/context/command"
import { Logo } from "@opencode-ai/ui/logo"
import Layout from "@/pages/layout"
import DirectoryLayout from "@/pages/directory-layout"
import { ErrorPage } from "./pages/error"
import { isLocalhostMode, AuthProvider, useAuth, type MachineStatus } from "@/context/auth"
import { LoginPage, ProvisioningScreen } from "@/pages/login"
import { iife } from "@opencode-ai/util/iife"
import { Suspense } from "solid-js"

const Home = lazy(() => import("@/pages/home"))
const Session = lazy(() => import("@/pages/session"))
const ChatLayout = lazy(() => import("@/pages/chat-layout").then((m) => ({ default: m.ChatLayout })))
const Loading = () => <div class="size-full" />

declare global {
  interface Window {
    __VOLTCODE__?: { updaterEnabled?: boolean; serverPassword?: string }
  }
}

export function AppBaseProviders(props: ParentProps) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider>
        <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
          <DialogProvider>
            <MarkedProvider>
              <DiffComponentProvider component={Diff}>
                <CodeComponentProvider component={Code}>{props.children}</CodeComponentProvider>
              </DiffComponentProvider>
            </MarkedProvider>
          </DialogProvider>
        </ErrorBoundary>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.url} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: { defaultUrl?: string }) {
  const defaultServerUrl = () => {
    if (props.defaultUrl) return props.defaultUrl
    if (isLocalhostMode()) {
      const host = import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"
      const port = import.meta.env.VITE_VOLTCODE_SERVER_PORT ?? "4096"
      return `http://${host}:${port}`
    }
    return window.location.origin
  }

  return (
    <AuthGate>
      <ServerProvider defaultUrl={defaultServerUrl()}>
        <ServerKey>
          <GlobalSDKProvider>
            <GlobalSyncProvider>
              <Router
                root={(props) => (
                  <PermissionProvider>
                    <LayoutProvider>
                      <NotificationProvider>
                        <CommandProvider>
                          <Layout>{props.children}</Layout>
                        </CommandProvider>
                      </NotificationProvider>
                    </LayoutProvider>
                  </PermissionProvider>
                )}
              >
                <Route
                  path="/"
                  component={() => (
                    <Suspense fallback={<Loading />}>
                      <Home />
                    </Suspense>
                  )}
                />
                <Route path="/:dir" component={DirectoryLayout}>
                  <Route
                    path="/"
                    component={() => (
                      <Suspense fallback={<Loading />}>
                        <ChatLayout />
                      </Suspense>
                    )}
                  />
                  <Route
                    path="/session/or/:dir/:id?"
                    component={() => (
                      <TerminalProvider>
                        <FileProvider>
                          <PromptProvider>
                            <Suspense fallback={<Loading />}>
                              <Session />
                            </Suspense>
                          </PromptProvider>
                        </FileProvider>
                      </TerminalProvider>
                    )}
                  />
                  <Route
                    path="/session/:id?"
                    component={() => (
                      <Suspense fallback={<Loading />}>
                        <ChatLayout />
                      </Suspense>
                    )}
                  />
                </Route>
              </Router>
            </GlobalSyncProvider>
          </GlobalSDKProvider>
        </ServerKey>
      </ServerProvider>
    </AuthGate>
  )
}

function AuthGate(props: ParentProps) {
  if (isLocalhostMode()) return <>{props.children}</>

  return (
    <AuthProvider>
      <AuthGateInner>{props.children}</AuthGateInner>
    </AuthProvider>
  )
}

function AuthGateInner(props: ParentProps) {
  const auth = useAuth()

  return (
    <Switch fallback={props.children}>
      <Match when={auth.state().loading}>
        <ProvisioningScreen message="Loading..." />
      </Match>
      <Match when={!auth.state().user}>
        <LoginPage />
      </Match>
      <Match when={auth.state().machineStatus !== "ready"}>
        <ProvisioningScreen
          message={machineStatusMessage(auth.state().machineStatus, auth.state().error)}
          onSignOut={() => auth.signOut()}
        />
      </Match>
    </Switch>
  )
}

function machineStatusMessage(status: MachineStatus, error: string | null): string {
  if (error) return error
  if (status === "provisioning") return "Preparing your VoltCode instance..."
  if (status === "polling") return "Connecting to your VoltCode instance..."
  return "Starting..."
}
