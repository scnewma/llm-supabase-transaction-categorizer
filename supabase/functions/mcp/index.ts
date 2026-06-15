import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { withMcp } from "@supabase/mcp-server-edge";
import { McpServer } from "npm:@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "npm:zod/v4";

const session = new Supabase.ai.Session("gte-small");

export default {
  fetch: withMcp(
    withSupabase(
      { auth: ["publishable", "secret"] },
      async (req, { supabase }) => {
        const server = new McpServer({
          name: "transaction-categorizer",
          version: "0.1.0",
        });

        server.registerTool(
          "store_transaction_example",
          {
            description:
              "Store a transaction as an example to be used for future categorization",
            inputSchema: z.object({
              date: z.string(),
              payee: z.string(),
              notes: z.string(),
              category: z.string(),
              amount: z.number(),
            }),
          },
          async ({ date, payee, notes, category, amount }) => {
            const embedding = await session.run(
              embeddingText({ payee, notes, amount }),
              {
                mean_pool: true,
                normalize: true,
              },
            );

            const { data, error } = await supabase
              .from("transactions")
              .insert({
                transaction_date: date,
                payee,
                notes,
                category,
                amount,
                embedding,
              })
              .select()
              .single();

            if (error) {
              throw new Error(`Failed to store transaction: ${error.message}`);
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ transaction: data }, null, 2),
                },
              ],
            };
          },
        );

        server.registerTool(
          "fetch_similar_transactions",
          {
            description:
              "Search for transactions similar to the provided fields.",
            inputSchema: z.object({
              payee: z.string(),
              notes: z.string(),
              amount: z.number(),
              match_count: z.number().int().positive().max(50).optional(),
            }),
          },
          async ({ payee, notes, amount, match_count }) => {
            const embedding = await session.run(
              embeddingText({ payee, notes, amount }),
              {
                mean_pool: true,
                normalize: true,
              },
            );

            const { data, error } = await supabase
              .rpc("match_transactions", {
                query_embedding: embedding,
                query_amount: amount,
                match_count: match_count ?? 20,
              });

            if (error) {
              throw new Error(`Failed to match transactions: ${error.message}`);
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ transactions: data }, null, 2),
                },
              ],
            };
          },
        );

        const transport = new WebStandardStreamableHTTPServerTransport();
        await server.connect(transport);
        return transport.handleRequest(req);
      },
    ),
  ),
};

function embeddingText(
  { payee, notes, amount }: { payee: string; notes: string; amount: number },
): string {
  const ttype = amount > 0 ? "credit" : "debit";
  const toEmbed =
    `Payee: ${payee}\nNotes: ${notes}\nTransaction type: ${ttype}`;
  return toEmbed;
}
