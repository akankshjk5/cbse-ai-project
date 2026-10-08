import Masonry from "./Masonry";

const styles = [
  { id: "1", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/2d%20line.webp", url: "#", height: 400, description: "2D Line" },
  { id: "2", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Blue%20collage.webp", url: "#", height: 250, description: "Collage" },
  { id: "3", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/3d%20animatoin.webp", url: "#", height: 600, description: "Animation" },
  { id: "4", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Blue%20vox.webp", url: "#", height: 350, description: "Blue Vox" },
  { id: "5", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Claymation.webp", url: "#", height: 450, description: "Claymation" },
  { id: "6", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Claire.webp", url: "#", height: 300, description: "Claire" },
  { id: "7", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Marcinelle.webp", url: "#", height: 500, description: "Marcinelle" },
  { id: "8", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Pen%20%26%20ink.webp", url: "#", height: 380, description: "Pen&Ink" },
  { id: "9", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Schematic.webp", url: "#", height: 420, description: "Schematic" },
  { id: "10", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Yellow%20vox.webp", url: "#", height: 360, description: "Vox" },
  { id: "11", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Watercolor.webp", url: "#", height: 480, description: "Watercolor" },
  { id: "12", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Papercraft.png", url: "#", height: 340, description: "Papercraft" },
  { id: "13", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Papercraft%20Peach.png", url: "#", height: 390, description: "Papercraft Mono" },
  { id: "14", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Halftone.webp", url: "#", height: 410, description: "Halftone" },
  { id: "15", img: "https://prod-ao-ext.cdn.opus.pro/story-mode/styles/Economic.webp", url: "#", height: 370, description: "Economic" },
];

export const VideoGallery = () => {
  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-5">Top Styles</h2>
      <Masonry
        items={styles}
        ease="power3.out"
        duration={0.6}
        stagger={0.05}
        animateFrom="bottom"
        scaleOnHover
        hoverScale={0.95}
        blurToFocus
        colorShiftOnHover={false}
      />
    </div>
  );
};
