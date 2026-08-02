export const SERVICES = [
  { id: "vocal-recording", name: "Vocal Recording Session", category: "recording", durationOptions: [120, 180, 240, 360, 480, 720], aliases: ["vocals", "vocal", "voc", "recording"] },
  { id: "band-recording", name: "Band Recording Session", category: "recording", durationOptions: [120, 180, 240, 360, 480, 720], aliases: ["band", "full band", "drum tracking", "band tracking"] },
  { id: "music-production", name: "Music Production", category: "production", durationOptions: [120, 180, 240, 360, 480, 720], aliases: ["production", "prod", "beat"] },
  { id: "mixing-mastering", name: "Mixing & Mastering", category: "mixing", durationOptions: [], aliases: ["mix", "master", "mixing", "mastering"] },
  { id: "complete-single", name: "The Complete Single", category: "packages", durationOptions: [], aliases: ["complete single", "full song", "whole song"] },
  { id: "custom-project", name: "Custom Project", category: "packages", durationOptions: [], aliases: ["custom", "custom project"] },
];

const normalized = (value) => String(value || "").trim().toLowerCase();

export const matchingServices = (query) => {
  const needle = normalized(query);
  if (!needle) return [];
  return SERVICES.filter((service) => (
    normalized(service.id) === needle
    || normalized(service.name) === needle
    || service.aliases.some((alias) => normalized(alias) === needle)
    || normalized(service.name).includes(needle)
  ));
};

export const serviceById = (id) => SERVICES.find((service) => service.id === id);
