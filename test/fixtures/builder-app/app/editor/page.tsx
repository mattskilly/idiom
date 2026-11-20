import { Canvas } from "../../components/Canvas";
import { Header } from "../../components/Header";
import { Inspector } from "../../components/Inspector";
import { Layers } from "../../components/Layers";
import { Library } from "../../components/Library";
import { Toolbar } from "../../components/Toolbar";

export default function Page() {
  return (
    <main>
      <Header />
      <Layers />
      <Canvas />
      <Toolbar />
      <Inspector />
      <Library />
    </main>
  );
}
