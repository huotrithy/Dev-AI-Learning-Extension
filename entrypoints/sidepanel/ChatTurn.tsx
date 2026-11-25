import type { ReactNode } from "react";

export function ChatTurn({ question, children, heading: Heading = "h2" }: {
  question: string;
  children: ReactNode;
  heading?: "h2" | "h3";
}) {
  return (
    <section className="chat-turn">
      <div className="chat-message chat-message-user">
        <p className="chat-message-label">You</p>
        <Heading className="chat-question">{question}</Heading>
      </div>
      <div className="chat-message chat-message-assistant">
        <p className="chat-message-label">AI</p>
        {children}
      </div>
    </section>
  );
}
