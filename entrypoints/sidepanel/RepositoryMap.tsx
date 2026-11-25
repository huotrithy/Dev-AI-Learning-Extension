import { architectureFlowchart, type RepositoryArchitecture } from "../../src/learning/architecture.ts";
import { Diagram } from "./Diagram.tsx";

export function RepositoryMap({ map, pending }: { map?: RepositoryArchitecture | null; pending: boolean }) {
  if (map === undefined && !pending)
    return null;

  const names = new Map(map?.components.map(({ id, name }) => [id, name]));
  return (
    <section className="learning-section repo-map">
      <h2>Repository architecture</h2>
      {map
        ? (
            <>
              <p className="muted">Based on the file excerpts read for this explanation.</p>
              {!!map.connections.length && (
                <Diagram
                  source={architectureFlowchart(map)}
                  description="Repository components and their connections. The component list below describes each connection and links to source files."
                />
              )}
              <ul className="repo-map-components" aria-label="Repository components">
                {map.components.map(({ id, name, files }) => {
                  const outgoing = map.connections.filter(({ from }) => from === id);
                  return (
                    <li key={id}>
                      <h3>{name}</h3>
                      <ul className="repo-map-files" aria-label={`Source files for ${name}`}>
                        {files.map(({ path, url }) => (
                          <li key={path}>
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {path}
                            </a>
                          </li>
                        ))}
                      </ul>
                      {!!outgoing.length && (
                        <ul className="muted repo-map-connections" aria-label={`Connections from ${name}`}>
                          {outgoing.map(({ to, label }, index) => (
                            <li key={index}>
                              {label}
                              {" "}
                              {names.get(to)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )
        : (
            <p role="status" className="muted">
              {pending ? "Mapping the inspected files…" : "No source-backed architecture map was available for these excerpts."}
            </p>
          )}
    </section>
  );
}
